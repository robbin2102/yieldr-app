export declare class RateLimiter {
    private tokens;
    private maxTokens;
    private refillRatePerMs;
    private lastRefill;
    private name;
    constructor(tokensPerMinute: number, name?: string);
    private refill;
    consume(count?: number): Promise<void>;
    getTokens(): number;
}
export declare function getCoinGlassRateLimiter(tokensPerMinute?: number): RateLimiter;
