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
    // OnChainDetector gives hex (e.g. "0xcb0a5f6c..."), Polymarket APIs use decimal.
    const tokenIdDec = tokenId.startsWith('0x') ? BigInt(tokenId).toString() : tokenId;

    // 1. Gamma API — native clob_token_ids filter (correct way to look up by tokenId)
    const gammaMarket = await this.fetchGamma(tokenIdDec);
    if (gammaMarket) {
      const meta = this.parseGammaMarket(gammaMarket, tokenIdDec, negRisk);
      if (meta) {
        // 2. CLOB lookup by conditionId — authoritative fee_rate_bps.
        //    Geopolitical/political markets are fee-free (0 bps) → FAK execution.
        //    Sports/other markets have fees (e.g. 200 bps = 2%) → GTD execution.
        meta.feeRateBps = await this.fetchFeeRate(meta.conditionId);
        return meta;
      }
    }

    // 3. CLOB fallback (Gamma unavailable) — lookup by conditionId not possible without
    //    Gamma, so this path returns feeRateBps=0 (defaults to FAK, safer than GTD hang).
    const clobMarket = await this.fetchClob(tokenIdDec);
    if (clobMarket) return this.parseClobMarket(clobMarket, tokenIdDec, negRisk);

    console.warn(`[MarketMetaResolver] Could not resolve tokenId ${tokenId.slice(0, 18)}... via gamma or clob`);
    return null;
  }

  // Fetch authoritative fee_rate_bps from CLOB using conditionId.
  // conditionId lookup (not tokenId) is the correct CLOB markets endpoint usage.
  private async fetchFeeRate(conditionId: string): Promise<number> {
    try {
      const url = `${this.clobApiBase}/markets/${conditionId}`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return 0;
      const data = await res.json() as any;
      const m    = data?.data ?? data;
      const raw  = m?.fee_rate_bps;
      const bps  = typeof raw === 'number' ? raw : parseInt(raw ?? '0', 10);
      console.log(`[MarketMetaResolver] fee_rate_bps=${isNaN(bps) ? 0 : bps} for conditionId=${conditionId.slice(0, 14)}...`);
      return isNaN(bps) ? 0 : bps;
    } catch {
      return 0;
    }
  }

  // ── Gamma API (gamma-api.polymarket.com) ──────────────────────────────────────

  private async fetchGamma(tokenIdDec: string): Promise<any | null> {
    const url = `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenIdDec}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) { console.warn(`[MarketMetaResolver] gamma HTTP ${res.status} for ${tokenIdDec.slice(0, 12)}...`); return null; }
      const data = await res.json() as any;
      const arr  = Array.isArray(data) ? data : (data?.data ?? []);
      if (arr.length === 0) { console.warn(`[MarketMetaResolver] gamma returned 0 markets for ${tokenIdDec.slice(0, 12)}...`); return null; }
      // Validate: the returned market must actually list our tokenId in clobTokenIds
      const m = arr.find((mkt: any) => {
        const ids = this.parseTokenIds(mkt.clobTokenIds ?? mkt.clob_token_ids);
        return ids.includes(tokenIdDec);
      });
      if (!m) { console.warn(`[MarketMetaResolver] gamma returned ${arr.length} market(s) but none list tokenId ${tokenIdDec.slice(0, 12)}...`); return null; }
      return m;
    } catch (e: any) { console.warn(`[MarketMetaResolver] gamma fetch failed:`, e.message); return null; }
  }

  private parseGammaMarket(m: any, tokenIdDec: string, negRisk: boolean): MarketMeta | null {
    const conditionId = m.conditionId ?? m.condition_id;
    if (!conditionId) return null;

    // Outcome label: gamma returns outcomes as a JSON-encoded array of strings ["Yes","No"],
    // and clobTokenIds as a parallel array. Match by index.
    const outcomes = this.parseOutcomes(m.outcomes);
    const ids      = this.parseTokenIds(m.clobTokenIds ?? m.clob_token_ids);
    const idx      = ids.indexOf(tokenIdDec);
    const outcome  = idx >= 0 && outcomes[idx] ? outcomes[idx] : '';

    return {
      conditionId,
      title:       (m.question ?? m.title ?? '') as string,
      outcome,
      negRisk,
      feeRateBps:  0, // gamma does not expose fee_rate_bps; safe default for detection-only
    };
  }

  private parseTokenIds(raw: any): string[] {
    if (Array.isArray(raw)) return raw.map((x: any) => String(x));
    if (typeof raw === 'string') {
      try { const j = JSON.parse(raw); return Array.isArray(j) ? j.map(String) : []; } catch { return []; }
    }
    return [];
  }
  private parseOutcomes(raw: any): string[] {
    if (Array.isArray(raw)) return raw.map((x: any) => String(x));
    if (typeof raw === 'string') {
      try { const j = JSON.parse(raw); return Array.isArray(j) ? j.map(String) : []; } catch { return []; }
    }
    return [];
  }

  // ── CLOB fallback (clob.polymarket.com) ───────────────────────────────────────
  // Only reached when Gamma is unavailable. CLOB /markets/{tokenId} is a long-shot —
  // CLOB indexes by conditionId, not tokenId, but some markets resolve via this path.

  private async fetchClob(tokenIdDec: string): Promise<any | null> {
    const url = `${this.clobApiBase}/markets/${tokenIdDec}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const m    = data?.data ?? data;
      if (!m?.condition_id) return null;
      const tokens: any[] = m.tokens ?? [];
      const matches = tokens.some((t: any) => String(t.token_id) === tokenIdDec);
      if (!matches) return null;
      return m;
    } catch { return null; }
  }

  private parseClobMarket(m: any, tokenIdDec: string, negRisk: boolean): MarketMeta {
    const tokens: any[] = m.tokens ?? [];
    const tok           = tokens.find((t: any) => String(t.token_id) === tokenIdDec);
    const feeRateBps    = typeof m.fee_rate_bps === 'number' ? m.fee_rate_bps : parseInt(m.fee_rate_bps ?? '0', 10);
    return {
      conditionId: m.condition_id as string,
      title:       (m.question ?? m.title ?? '') as string,
      outcome:     (tok?.outcome ?? '') as string,
      negRisk,
      feeRateBps:  isNaN(feeRateBps) ? 0 : feeRateBps,
    };
  }
}
