export declare const config: {
    port: number;
    readonly mongodbUri: string;
    taapi: {
        readonly apiKey: string;
        baseUrl: string;
        exchange: string;
        interval: string;
        rateDelayMs: number;
    };
    coinglass: {
        readonly apiKey: string;
        baseUrl: string;
        rateDelayMs: number;
        tokensPerMinute: number;
    };
    binance: {
        spotBaseUrl: string;
    };
    fullDerivativesTier: number;
    totalTrackedCoins: number;
    onDemandCacheTtlMs: number;
};
