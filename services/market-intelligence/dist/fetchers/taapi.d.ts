export interface TaapiCoinData {
    indicators: Record<string, unknown>;
    candlestick_patterns: Array<{
        pattern: string;
        value: number;
        timeframe: string;
    }>;
    errors: string[];
}
export declare function fetchCoreIndicators(symbol: string): Promise<Record<string, unknown>>;
export declare function fetchStructureIndicators(symbols: string[]): Promise<Map<string, Record<string, unknown>>>;
export declare function fetchPatternBatch(symbols: string[], patterns: string[]): Promise<Map<string, Record<string, number>>>;
export declare function fetchAllForCoin(symbol: string): Promise<TaapiCoinData>;
export declare function fetchAllCoins(coins: string[]): Promise<Map<string, TaapiCoinData>>;
