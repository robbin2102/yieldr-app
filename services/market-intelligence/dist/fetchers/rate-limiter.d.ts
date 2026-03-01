/**
 * Token-bucket rate limiter shared between cron and on-demand CoinGlass calls.
 * Configured for 28 tokens/minute (leaves 2-token buffer from 30 req/min Hobby plan).
 */
export declare class RateLimiter {
    private tokens;
    private readonly maxTokens;
    private readonly refillRatePerMs;
    private lastRefill;
    private readonly name;
    constructor(tokensPerMinute: number, name?: string);
    private refill;
    /**
     * Consume `count` tokens, waiting if not enough available.
     */
    consume(count?: number): Promise<void>;
    getTokens(): number;
}
export declare function getCoinGlassRateLimiter(tokensPerMinute?: number): RateLimiter;
