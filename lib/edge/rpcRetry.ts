/**
 * Shared 429/rate-limit detection + backoff-retry for RPC calls.
 *
 * Deliberately separate from "this range is too large, split it" handling
 * (see bulkLogScan.ts) - those two failure modes need OPPOSITE responses.
 * A rate limit means "you're sending requests too fast"; retrying the same
 * request after a real backoff is correct. Treating a 429 like a
 * range-too-large error and bisecting into more concurrent requests would
 * make the rate limiting worse, not better.
 */

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 2000;

export function isRateLimitError(err: any): boolean {
  const text = `${err?.message ?? ''} ${err?.details ?? ''} ${err?.shortMessage ?? ''}`;
  return text.includes('429') || /too many requests/i.test(text);
}

/** Retries `fn` with exponential backoff, but ONLY when the failure looks like a 429 - any other error rethrows immediately. */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isRateLimitError(err) || attempt >= maxRetries) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs * 0.25);
      console.log(
        `[edge:rpcRetry]${opts.label ? ` ${opts.label}` : ''} rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
