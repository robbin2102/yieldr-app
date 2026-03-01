export declare const config: {
    readonly port: number;
    readonly mongodbUri: string;
    readonly taapi: {
        readonly apiKey: string;
        readonly baseUrl: "https://api.taapi.io";
        readonly exchange: "binancefutures";
        readonly interval: "1h";
        readonly rateDelayMs: number;
    };
    readonly coinglass: {
        readonly apiKey: string;
        readonly baseUrl: "https://open-api-v4.coinglass.com";
        readonly rateDelayMs: number;
        readonly tokensPerMinute: 28;
    };
    readonly fullDerivativesTier: 20;
    readonly totalTrackedCoins: 100;
    readonly onDemandCacheTtlMs: number;
};
