/**
 * Queries the binance_funding_8h and binance_derivatives_15m collections
 * written by the binance-fetcher service (Singapore Railway deployment).
 * Uses the raw mongoose connection to avoid registering duplicate Mongoose models.
 */
export interface BinanceFundingData {
    funding_rate: number;
    annualized_rate: number;
    timestamp: Date;
}
export interface BinanceDerivativesData {
    oi: {
        total_usdt: number | null;
        change_4h_pct: number | null;
        change_24h_pct: number | null;
    };
    long_short_global: {
        long: number | null;
        short: number | null;
        ratio: number | null;
    };
    long_short_top_accounts: {
        long: number | null;
        short: number | null;
        ratio: number | null;
    };
    long_short_top_positions: {
        long: number | null;
        short: number | null;
        ratio: number | null;
    };
    timestamp: Date | null;
}
/**
 * Returns the latest funding rate record for a symbol from binance_funding_8h.
 * Returns null if the collection is empty or symbol not found.
 */
export declare function getLatestBinanceFunding(symbol: string): Promise<BinanceFundingData | null>;
/**
 * Returns the latest OI + long/short ratio data for a symbol from binance_derivatives_15m.
 * Fetches the last 97 records to compute 4h and 24h OI change.
 * Returns null if the collection is empty or symbol not found.
 */
export declare function getLatestBinanceDerivatives(symbol: string): Promise<BinanceDerivativesData | null>;
