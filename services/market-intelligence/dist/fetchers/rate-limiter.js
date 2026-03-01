"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
exports.getCoinGlassRateLimiter = getCoinGlassRateLimiter;
const logger_1 = require("../utils/logger");
/**
 * Token-bucket rate limiter shared between cron and on-demand CoinGlass calls.
 * Configured for 28 tokens/minute (leaves 2-token buffer from 30 req/min Hobby plan).
 */
class RateLimiter {
    tokens;
    maxTokens;
    refillRatePerMs; // tokens added per millisecond
    lastRefill;
    name;
    constructor(tokensPerMinute, name = 'RateLimiter') {
        this.maxTokens = tokensPerMinute;
        this.tokens = tokensPerMinute;
        this.refillRatePerMs = tokensPerMinute / 60000;
        this.lastRefill = Date.now();
        this.name = name;
    }
    refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
        this.lastRefill = now;
    }
    /**
     * Consume `count` tokens, waiting if not enough available.
     */
    async consume(count = 1) {
        while (true) {
            this.refill();
            if (this.tokens >= count) {
                this.tokens -= count;
                logger_1.logger.debug(this.name, `Token consumed. Remaining: ${this.tokens.toFixed(1)}/${this.maxTokens}`);
                return;
            }
            // Calculate wait time until we have enough tokens
            const deficit = count - this.tokens;
            const waitMs = Math.ceil(deficit / this.refillRatePerMs);
            logger_1.logger.debug(this.name, `Rate limit: waiting ${waitMs}ms for ${count} token(s)`);
            await sleep(waitMs);
        }
    }
    getTokens() {
        this.refill();
        return this.tokens;
    }
}
exports.RateLimiter = RateLimiter;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Singleton shared CoinGlass rate limiter (28 req/min, leaves 2-token buffer)
let _cgRateLimiter = null;
function getCoinGlassRateLimiter(tokensPerMinute = 28) {
    if (!_cgRateLimiter) {
        _cgRateLimiter = new RateLimiter(tokensPerMinute, 'CoinGlass');
        logger_1.logger.info('RateLimiter', `CoinGlass rate limiter initialized: ${tokensPerMinute} req/min`);
    }
    return _cgRateLimiter;
}
//# sourceMappingURL=rate-limiter.js.map