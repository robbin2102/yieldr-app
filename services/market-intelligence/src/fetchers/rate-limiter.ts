import { logger } from '../utils/logger';

export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRatePerMs: number;
  private lastRefill: number;
  private name: string;

  constructor(tokensPerMinute: number, name = 'RateLimiter') {
    this.maxTokens = tokensPerMinute;
    this.tokens = tokensPerMinute;
    this.refillRatePerMs = tokensPerMinute / 60000;
    this.lastRefill = Date.now();
    this.name = name;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }

  async consume(count = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        logger.debug(this.name, `Token consumed. Remaining: ${this.tokens.toFixed(1)}/${this.maxTokens}`);
        return;
      }
      const deficit = count - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillRatePerMs);
      logger.debug(this.name, `Rate limit: waiting ${waitMs}ms for ${count} token(s)`);
      await sleep(waitMs);
    }
  }

  getTokens(): number {
    this.refill();
    return this.tokens;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let _cgRateLimiter: RateLimiter | null = null;

export function getCoinGlassRateLimiter(tokensPerMinute = 28): RateLimiter {
  if (!_cgRateLimiter) {
    _cgRateLimiter = new RateLimiter(tokensPerMinute, 'CoinGlass');
    logger.info('RateLimiter', `CoinGlass rate limiter initialized: ${tokensPerMinute} req/min`);
  }
  return _cgRateLimiter;
}
