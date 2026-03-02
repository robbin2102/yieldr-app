/** OHLCV candle data — fetched from Coinbase Advanced Trade API (was Binance). */
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
 * Fetches the last COMPLETE 1h candle + previous day's OHLC for a given symbol
 * from the Coinbase Advanced Trade public REST API.
 */
export declare function fetchBinanceCandle(symbol: string): Promise<BinanceCandleData>;
