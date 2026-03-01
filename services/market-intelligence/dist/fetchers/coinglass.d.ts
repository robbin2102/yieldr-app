export interface CoinAggregateData {
    symbol: string;
    open_interest_usd: number | null;
    oi_change_24h_pct: number | null;
    price: number | null;
    volume_24h: number | null;
    funding_rate_current: number | null;
    liq_long_24h: number | null;
    liq_short_24h: number | null;
    taker_buy_vol: number | null;
    taker_sell_vol: number | null;
    taker_ratio: number | null;
    basis: number | null;
}
/**
 * Fetch all aggregate data (Phase 1).
 * Returns a map of { symbol → CoinAggregateData }.
 */
export declare function fetchAggregateData(trackedCoins: string[]): Promise<Map<string, CoinAggregateData>>;
export interface CoinPerCoinData {
    symbol: string;
    funding_rate_history: any[];
    funding_arbitrage: Array<{
        long_exchange: string;
        short_exchange: string;
        spread: number;
    }>;
    oi_history: any[];
    long_short_global: {
        long: number | null;
        short: number | null;
    };
    long_short_top_accounts: {
        long: number | null;
        short: number | null;
    };
    long_short_top_positions: {
        long: number | null;
        short: number | null;
    };
    liq_history: any[];
    taker_history: any[];
    cvd_history: any[];
    net_flow: number | null;
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
