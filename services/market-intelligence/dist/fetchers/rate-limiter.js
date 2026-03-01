"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
exports.getCoinGlassRateLimiter = getCoinGlassRateLimiter;
const logger_1 = require("../utils/logger");
class RateLimiter {
    tokens;
    maxTokens;
    refillRatePerMs;
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
    async consume(count = 1) {
        while (true) {
            this.refill();
            if (this.tokens >= count) {
                this.tokens -= count;
                logger_1.logger.debug(this.name, `Token consumed. Remaining: ${this.tokens.toFixed(1)}/${this.maxTokens}`);
                return;
            }
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
let _cgRateLimiter = null;
function getCoinGlassRateLimiter(tokensPerMinute = 28) {
    if (!_cgRateLimiter) {
        _cgRateLimiter = new RateLimiter(tokensPerMinute, 'CoinGlass');
        logger_1.logger.info('RateLimiter', `CoinGlass rate limiter initialized: ${tokensPerMinute} req/min`);
    }
    return _cgRateLimiter;
}
//# sourceMappingURL=rate-limiter.js.map