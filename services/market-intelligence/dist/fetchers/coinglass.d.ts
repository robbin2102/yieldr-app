export interface CoinAggregateData {
    symbol: string;
    funding_rate_current: number | null;
    liq_long_24h: number | null;
    liq_short_24h: number | null;
}
export declare function fetchAggregateData(trackedCoins: string[]): Promise<Map<string, CoinAggregateData>>;
export interface CoinPerCoinData {
    symbol: string;
    funding_rate_history: any[];
    oi_weighted_funding_history: any[];
    oi_history: any[];
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
    liq_history: any[];
    taker_history: any[];
    basis: number | null;
    errors: string[];
}
export declare function fetchPerCoinData(symbol: string): Promise<CoinPerCoinData>;
export declare function fetchCoinbasePremium(): Promise<{
    btc: number | null;
    eth: number | null;
}>;
export declare function fetchMacroData(): Promise<{
    btcEtfFlows: any;
    ethEtfFlows: any;
    btcEtfNetAssets: any;
    fearGreed: any;
    stablecoinMcap: any;
}>;
