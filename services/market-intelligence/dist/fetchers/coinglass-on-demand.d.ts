/**
 * On-demand CoinGlass fetch for coins 21-100.
 * Checks cache first; fetches and merges if stale or missing.
 */
export declare function fetchOnDemand(symbol: string): Promise<Record<string, unknown> | null>;
