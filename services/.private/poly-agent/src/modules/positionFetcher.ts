import { config } from '../config';
import { CopyTrader } from '../db/models/CopyTrader';

interface PositionEntry {
  tokenId: string;
  size: number;       // shares held
  avgPrice: number;   // avg cost per share (if available)
  usdcValue: number;  // size × avgPrice (proxy for capital deployed)
}

interface CachedPositions {
  fetchedAt: number;
  totalUsdc: number;
  positions: PositionEntry[];
}

/**
 * PositionFetcher — fetches and caches a trader's open positions from Polymarket.
 *
 * Used as the denominator in portfolio-proportional copy sizing:
 *   copy_ratio = trader.allocationUsdc / trader.openPositionsUsdc
 *
 * Cache TTL (POSITIONS_CACHE_TTL_MS, default 60s) prevents hammering the API
 * on every poll tick. One fetch per trader per poll cycle is the expected pattern.
 *
 * Fallback when positions = 0 or fetch fails:
 *   Use trader.avgBet × trader.actsPerDay as a rough proxy for capital deployed.
 *   This prevents division by zero on newly-started traders.
 */
export class PositionFetcher {
  private cache = new Map<string, CachedPositions>();  // key: trader wallet

  /**
   * Get total USDC value of a trader's open positions.
   * Returns cached value if within TTL, otherwise fetches fresh.
   */
  async getTotalOpenUsdc(wallet: string): Promise<number> {
    const cached = this.cache.get(wallet);
    if (cached && (Date.now() - cached.fetchedAt) < config.positionsCacheTtlMs) {
      return cached.totalUsdc;
    }

    const result = await this.fetchPositions(wallet);
    this.cache.set(wallet, result);

    // Persist to DB for visibility in manage-copy-traders script
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      { $set: { openPositionsUsdc: result.totalUsdc } }
    ).catch(() => {});  // non-critical, don't fail on DB error

    return result.totalUsdc;
  }

  /**
   * Get full position list for a trader (used by SELL guard to check our copy positions).
   */
  async getPositions(wallet: string): Promise<PositionEntry[]> {
    const cached = this.cache.get(wallet);
    if (cached && (Date.now() - cached.fetchedAt) < config.positionsCacheTtlMs) {
      return cached.positions;
    }

    const result = await this.fetchPositions(wallet);
    this.cache.set(wallet, result);
    return result.positions;
  }

  private async fetchPositions(wallet: string): Promise<CachedPositions> {
    try {
      const url = `${config.dataApiBase}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[PositionFetcher] ${wallet.slice(0, 10)}...: API ${res.status}`);
        return this.emptyCache();
      }

      const raw = await res.json() as any;
      const items: any[] = Array.isArray(raw) ? raw : raw.data ?? [];

      const positions: PositionEntry[] = [];
      let totalUsdc = 0;

      for (const item of items) {
        const size = parseFloat(item.size ?? item.sharesOwned ?? '0');
        if (size < 0.01) continue;

        // avgPrice may be 'initialValue/size' or directly provided
        const avgPrice = parseFloat(item.avgPrice ?? item.averagePrice ?? '0') ||
          (item.initialValue ? parseFloat(item.initialValue) / size : 0);

        // Fallback: if no avgPrice, use current price
        const priceToUse = avgPrice > 0 ? avgPrice : parseFloat(item.currentPrice ?? item.price ?? '0.5');
        const usdcValue = size * priceToUse;

        positions.push({
          tokenId: item.asset ?? item.tokenId ?? '',
          size,
          avgPrice: priceToUse,
          usdcValue,
        });

        totalUsdc += usdcValue;
      }

      return { fetchedAt: Date.now(), totalUsdc, positions };

    } catch (err: any) {
      console.warn(`[PositionFetcher] ${wallet.slice(0, 10)}...: fetch error — ${err.message}`);
      return this.emptyCache();
    }
  }

  private emptyCache(): CachedPositions {
    return { fetchedAt: Date.now(), totalUsdc: 0, positions: [] };
  }

  /** Invalidate cache for a wallet (e.g. after a fill) */
  invalidate(wallet: string): void {
    this.cache.delete(wallet);
  }
}

export const positionFetcher = new PositionFetcher();
