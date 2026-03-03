export interface BinanceCandleData {
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
 * Fetches the last COMPLETE 1h candle + previous day's OHLC for a given symbol.
 * Binance klines response: [open_time, open, high, low, close, volume, close_time, ...]
 */
export declare function fetchBinanceCandle(symbol: string): Promise<BinanceCandleData>;
/** Returns the set of symbols skipped this session due to missing Binance spot pair. */
export declare function getNoSpotSymbols(): ReadonlySet<string>;
