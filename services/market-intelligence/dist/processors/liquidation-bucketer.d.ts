interface LiqBucket {
    price_low: number;
    price_high: number;
    long_liq_usd: number;
    short_liq_usd: number;
    total_usd: number;
    count: number;
}
export declare function bucketLiquidations(symbol: string, liqHistory: any[], currentPrice: number | null): Promise<LiqBucket[]>;
export {};
