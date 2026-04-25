/**
 * MarketMetaResolver — maps tokenId → market metadata.
 *
 * OnChainDetector gives us tokenId (ERC1155 token ID) but not conditionId,
 * title, outcome, or feeRateBps. This module resolves that gap.
 *
 * The tokenId encodes the conditionId + outcome index in the lower bits,
 * but decoding it requires knowing the contract's encoding scheme, which
 * is undocumented. Safer approach: look up via CLOB API and cache forever
 * (conditionId, title, outcome, negRisk never change for a market).
 *
 * negRisk is inferred from the exchange address in DetectedTrade — this
 * avoids the per-order API call that v1 made for every new market.
 *
 * Cache is persisted to disk so it survives process restarts.
 * A market seen once is never fetched again.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { MarketMeta } from '../types';

const CACHE_PATH = resolve(__dirname, '../../../data/market-meta-cache.json');

function loadFromDisk(): Map<string, MarketMeta> {
  try {
    if (existsSync(CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      return new Map(Object.entries(raw));
    }
  } catch { /* corrupt — start fresh */ }
  return new Map();
}

function saveToDisk(cache: Map<string, MarketMeta>): void {
  try {
    mkdirSync(resolve(CACHE_PATH, '..'), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(cache)));
  } catch (e: any) {
    console.warn('[MarketMetaResolver] Could not persist cache:', e.message);
  }
}

export class MarketMetaResolver {
  // tokenId → MarketMeta (disk-persisted, never expires)
  private cache:    Map<string, MarketMeta> = loadFromDisk();
  // tokenId → in-flight promise (dedup concurrent lookups for same token)
  private inflight: Map<string, Promise<MarketMeta | null>> = new Map();

  constructor(
    private readonly clobApiBase: string,
  ) {}

  /**
   * Resolve metadata for a tokenId.
   * negRisk is provided by the caller (from DetectedTrade.exchange).
   * Returns null if the CLOB API cannot be reached after retries.
   */
  async resolve(tokenId: string, negRisk: boolean): Promise<MarketMeta | null> {
    const cached = this.cache.get(tokenId);
    if (cached) return cached;

    if (this.inflight.has(tokenId)) {
      return this.inflight.get(tokenId)!;
    }

    const promise = this.fetch(tokenId, negRisk).then(meta => {
      this.inflight.delete(tokenId);
      if (meta) {
        this.cache.set(tokenId, meta);
        saveToDisk(this.cache);
      }
      return meta;
    }).catch(() => {
      this.inflight.delete(tokenId);
      return null;
    });

    this.inflight.set(tokenId, promise);
    return promise;
  }

  get cacheSize(): number { return this.cache.size; }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async fetch(tokenId: string, negRisk: boolean): Promise<MarketMeta | null> {
    // CLOB v2 markets endpoint: GET /markets?token_id=<tokenId>
    // Falls back to GET /markets/<tokenId> if the first returns nothing
    for (const url of [
      `${this.clobApiBase}/markets?token_id=${tokenId}`,
      `${this.clobApiBase}/markets/${tokenId}`,
    ]) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) continue;

        const data = await res.json() as any;
        // Response may be a single object or an array with one element
        const market = Array.isArray(data) ? data[0] : data;
        if (!market?.condition_id) continue;

        // Fee rate: geopolitical markets typically 0, others vary
        const feeRateBps = typeof market.fee_rate_bps === 'number'
          ? market.fee_rate_bps
          : parseInt(market.fee_rate_bps ?? '0', 10);

        return {
          conditionId: market.condition_id as string,
          title:       (market.question ?? market.title ?? '') as string,
          outcome:     (market.outcome_descriptions?.[0] ?? market.outcome ?? '') as string,
          negRisk,
          feeRateBps:  isNaN(feeRateBps) ? 0 : feeRateBps,
        };
      } catch { continue; }
    }
    return null;
  }
}
