/**
 * Refresh the dynamic tracked coins list.
 * Steps:
 * 1. TAAPI exchange-symbols → available symbols on binancefutures
 * 2. CoinGlass coins-markets → all coins with OI
 * 3. Intersect → top 100 by OI
 * 4. Save to tracked_coins collection
 */
export declare function refreshTrackedCoins(): Promise<{
    all: string[];
    full: string[];
    lite: string[];
}>;
/**
 * Load tracked coins from DB. Falls back to refreshing if not found.
 */
export declare function loadTrackedCoins(): Promise<{
    all: string[];
    full: string[];
    lite: string[];
}>;
