/**
 * Fetch BULK 1 — 20 core indicators for a single coin.
 * Returns structured indicator data.
 */
export declare function fetchCoreIndicators(symbol: string): Promise<Record<string, unknown>>;
/**
 * Fetch BULK 2 — fibonacci + swing high/low for a group of 3 coins (multi-construct).
 * Returns map of { symbol → indicator data }.
 */
export declare function fetchStructureIndicators(symbols: string[]): Promise<Map<string, Record<string, unknown>>>;
/**
 * Fetch a batch of candlestick patterns for a group of up to 3 coins (multi-construct).
 * patternsChunk: up to 6 patterns per symbol (3 × 6 = 18 calcs ≤ 20).
 */
export declare function fetchPatternBatch(symbols: string[], patterns: string[]): Promise<Map<string, Record<string, number>>>;
/**
 * Full fetch for a single coin: core indicators + structure indicators + all patterns.
 * Returns all data needed to build a snapshot.
 */
export interface TaapiCoinData {
    indicators: Record<string, unknown>;
    candlestick_patterns: Array<{
        pattern: string;
        value: number;
        timeframe: string;
    }>;
    errors: string[];
}
export declare function fetchAllForCoin(symbol: string): Promise<TaapiCoinData>;
/**
 * Orchestrator: fetch all TAAPI data for all 100 coins.
 * Returns map of { symbol → TaapiCoinData }.
 */
export declare function fetchAllCoins(coins: string[]): Promise<Map<string, TaapiCoinData>>;
